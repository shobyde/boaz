// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createDomContextReader } from '../src/dom/index.js';

const page = () => {
  document.body.innerHTML = `
    <section id="about"><h2>About</h2><p>Twelve years building APIs and cloud systems. Leads UI engineering and UX design.</p></section>
    <section id="projects"><h2>Projects</h2><p>Hobnob is a private meeting recorder that runs on device. Readback is a self hosted reading tracker for families.</p></section>
    <section id="experience"><h2>Experience</h2><p>Engineering manager at Conversica since 2021. Earlier: PHP and Node work at agencies.</p></section>
    <section id="empty"></section>
  `;
};

describe('createDomContextReader', () => {
  it('reads the declared sections and labels them', () => {
    page();
    const read = createDomContextReader({
      sections: [
        { selector: '#about', label: 'About' },
        { selector: '#projects', label: 'Projects' },
      ],
    });
    const text = read('');
    expect(text).toContain('### About');
    expect(text).toContain('Twelve years building APIs');
    expect(text).toContain('### Projects');
    expect(text).toContain('Hobnob');
  });

  it('puts the section that matches the question first', () => {
    page();
    const read = createDomContextReader({
      sections: [
        { selector: '#about', label: 'About' },
        { selector: '#projects', label: 'Projects' },
        { selector: '#experience', label: 'Experience' },
      ],
    });
    const text = read('where did he work before Conversica?');
    expect(text.indexOf('### Experience')).toBeLessThan(text.indexOf('### Projects'));
  });

  it('skips empty sections and unknown selectors', () => {
    page();
    const read = createDomContextReader({
      sections: [
        { selector: '#empty', label: 'Empty' },
        { selector: '#missing', label: 'Missing' },
        { selector: '#about', label: 'About' },
      ],
    });
    const text = read('anything');
    expect(text).not.toContain('Empty');
    expect(text).not.toContain('Missing');
    expect(text).toContain('### About');
  });

  it('honours the character budget and says when it truncates', () => {
    page();
    const read = createDomContextReader({
      sections: [
        { selector: '#about', label: 'About' },
        { selector: '#projects', label: 'Projects' },
        { selector: '#experience', label: 'Experience' },
      ],
      maxChars: 400,
      perSectionChars: 40,
    });
    const text = read('');
    expect(text).toContain('…');
    expect(text.length).toBeLessThanOrEqual(400);
  });

  it('returns an empty string when nothing matches', () => {
    document.body.innerHTML = '<div id="none"></div>';
    const read = createDomContextReader({ sections: [{ selector: '#none', label: 'Nothing' }] });
    expect(read('hello')).toBe('');
  });
});
