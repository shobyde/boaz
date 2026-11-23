# Media

Three stills from the demo in `apps/demo`, captured at 1440×900 from a Chromium
session at device pixel ratio 1.

| File | State |
| --- | --- |
| `dashboard.png` | `/` with the assistant docked; empty state listing the five declared routes |
| `billing-filter.png` | after `show only the overdue invoices` — the runtime navigated to `/settings/billing`, called `billing.filter_invoices {status: "overdue"}`, and the table now shows three rows |
| `confirm-gate.png` | after `delete this workspace` — the confirmation card for `account.delete`, with Confirm/Cancel above the composer |

Reproduce:

```bash
pnpm build
pnpm --filter demo preview        # http://localhost:4173
```

Open the page, click **Ask the assistant**, send the quoted message, and capture
the viewport while the engine is `Keyword search · no download`. No model
download is involved, so the same images are reproducible on a machine without
WebGPU.

Two capture notes, both learned the hard way:

- Assistant message bubbles use `from-user` / `from-assistant` classes. An
  earlier version reused `assistant` for the bubble, which matched the panel's
  `position: fixed` rule and made the last bubble cover the panel in
  screenshots while the DOM looked correct.
- Capturing at device pixel ratio 2 returned stale frames in the harness used
  here; DPR 1 after a reload produced frames matching the live DOM.
