import { describe, expect, it } from 'vitest';
import {
  describeResolution,
  flattenTree,
  normaliseName,
  parseAction,
  resolveAction,
  type ActionNode,
} from '../src/core/actions.js';

/** A small page shaped like the site: a nav, a chat panel, a card list. */
function siteTree(): ActionNode[] {
  return [
    {
      role: 'navigation',
      name: 'Main',
      children: [
        { role: 'link', name: 'Work' },
        { role: 'link', name: 'Projects' },
        { role: 'link', name: 'Blog' },
      ],
    },
    {
      role: 'region',
      name: 'Chat panel',
      children: [
        { role: 'textbox', name: 'Message' },
        { role: 'button', name: 'Send' },
        { role: 'button', name: 'Send', disabled: true },
      ],
    },
    {
      role: 'region',
      name: 'Reading list',
      children: [
        { role: 'button', name: 'Read more' },
        { role: 'button', name: 'Read more' },
      ],
    },
    { role: 'heading', name: 'Work experience' },
    { role: 'textbox', name: 'Search' },
    { role: 'button', name: 'Close', hidden: true },
    { role: 'button', name: 'Menu' },
    { role: 'button', name: 'Submit', disabled: true },
  ];
}

describe('parseAction', () => {
  it('reads a verb, a role and a name', () => {
    expect(parseAction('click the send button')).toEqual({ verb: 'click', role: 'button', name: 'send' });
    expect(parseAction('Press "Read more"')).toMatchObject({ verb: 'click', name: 'read more' });
  });

  it('reads a value and a target for a fill, in both word orders', () => {
    expect(parseAction('type sho@example.com into the email field')).toMatchObject({
      verb: 'fill',
      role: 'textbox',
      name: 'email',
      text: 'sho@example.com',
    });
    expect(parseAction('fill the message box with hello there')).toMatchObject({
      verb: 'fill',
      role: 'textbox',
      name: 'message',
      text: 'hello there',
    });
  });

  it('keeps a role-only target', () => {
    expect(parseAction('fill the search box with typescript')).toEqual({
      verb: 'fill',
      role: 'searchbox',
      hint: 'search box',
      text: 'typescript',
    });
  });

  it('reads an ordinal and a scope', () => {
    expect(parseAction('click the second read more button')).toMatchObject({ ordinal: 2, role: 'button', name: 'read more' });
    expect(parseAction('click send in the chat panel')).toMatchObject({ name: 'send', scope: 'chat' });
  });

  it('declines a sentence that is not an action', () => {
    expect(parseAction('which projects use python')).toBeNull();
    expect(parseAction('click')).toBeNull();
  });
});

describe('resolveAction', () => {
  const nodes = flattenTree(siteTree());

  it('resolves an exact name and role', () => {
    const found = resolveAction('click the blog link', nodes);
    expect(found.ok).toBe(true);
    expect(found.node?.name).toBe('Blog');
    expect(found.reason).toBe('resolved');
  });

  it('refuses two controls with the same name instead of picking one', () => {
    const found = resolveAction('click the read more button', nodes);
    expect(found.ok).toBe(false);
    expect(found.reason).toBe('ambiguous');
    expect(found.considered).toHaveLength(2);
    expect(describeResolution(found)).toContain('Nothing was clicked');
  });

  it('uses the scope to break a tie', () => {
    const found = resolveAction('click send in the chat panel', nodes);
    expect(found.ok).toBe(true);
    expect(found.node?.role).toBe('button');
  });

  it('picks the nth tie when the visitor asked for one', () => {
    const first = resolveAction('click the first read more button', nodes);
    const second = resolveAction('click the second read more button', nodes);
    expect(first.ok && second.ok).toBe(true);
    expect(second.index).toBeGreaterThan(first.index ?? 0);
  });

  it('reports a hidden control as hidden, not absent', () => {
    const found = resolveAction('click the close button', nodes);
    expect(found.ok).toBe(false);
    expect(found.reason).toBe('hidden');
  });

  it('reports the wrong role rather than the nearest wrong control', () => {
    const found = resolveAction('click the terms checkbox', nodes);
    expect(found.ok).toBe(false);
    expect(found.reason).toBe('role-mismatch');
  });

  it('names the near miss when the right name sits on another role', () => {
    const found = resolveAction('click the projects button', nodes);
    expect(found.ok).toBe(false);
    expect(found.reason).toBe('name-mismatch');
    expect(found.nearMiss?.role).toBe('link');
    expect(describeResolution(found)).toContain('Projects link');
  });

  it('resolves a role-only fill target and carries the value', () => {
    const found = resolveAction('fill the search box with typescript', nodes);
    expect(found.ok).toBe(true);
    expect(found.node?.name).toBe('Search');
    expect(found.request?.text).toBe('typescript');
  });

  it('matches a name whose words the visitor reordered', () => {
    const found = resolveAction('scroll to experience work', nodes);
    expect(found.ok).toBe(true);
    expect(found.node?.name).toBe('Work experience');
  });

  it('does not act on a disabled control', () => {
    const found = resolveAction('click the submit button', nodes);
    expect(found.ok).toBe(false);
    expect(found.reason).toBe('disabled');
    expect(describeResolution(found)).toContain('disabled');
  });

  it('ignores a disabled twin when the live control shares its name', () => {
    const found = resolveAction('click send in the chat panel', nodes);
    expect(found.ok).toBe(true);
    expect(found.node?.disabled).toBeFalsy();
  });

  it('returns no-verb for a question', () => {
    expect(resolveAction('what do you know about hobnob', nodes).reason).toBe('no-verb');
  });
});

describe('normaliseName', () => {
  it('drops case, quotes, articles and ampersands', () => {
    expect(normaliseName('The “Send” & Close')).toBe('send and close');
  });
});
