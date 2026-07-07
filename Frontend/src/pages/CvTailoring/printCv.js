// Print-to-PDF in an isolated iframe: its own document + stylesheet, so the
// host page's fixed-position modals and theme CSS can never blank the output.
// Keep the styles visually in sync with the .cv-doc rules in cvTailoring.css
// (base = "editorial", plus the .cv-t-* template variants).

export const PRINT_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; }
  .cv-doc {
    font-size: 13px; color: #141414; background: #fff;
    font-family: "Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif;
    padding: 0; box-shadow: none; border-radius: 0;
  }
  .cv-doc p, .cv-doc span, .cv-doc div, .cv-doc h1, .cv-doc h2 { color: #141414; }
  .cv-head { border-bottom: 2px solid #141414; padding-bottom: 1.3em; margin-bottom: 0.3em; }
  .cv-name { font-family: Georgia, "Times New Roman", serif; font-size: 2.3em; font-weight: 700; margin: 0; color: #000; line-height: 1.1; }
  .cv-role { margin: 0.55em 0 0; font-size: 0.8em; letter-spacing: 0.22em; text-transform: uppercase; color: #0f5c5a; font-weight: 700; }
  .cv-contact-row { margin: 0.9em 0 0; font-size: 0.82em; color: #333; display: flex; flex-wrap: wrap; gap: 0.35em 2em; }
  .cv-contact-row span { color: #333; }
  .cv-row { display: grid; grid-template-columns: 9.5em 1fr; gap: 1.6em; padding: 1.15em 0; border-bottom: 1px solid #e8e8e6; }
  .cv-row:last-child { border-bottom: none; }
  .cv-label { font-size: 0.7em; letter-spacing: 0.18em; text-transform: uppercase; font-weight: 700; color: #0f5c5a; padding-top: 0.3em; break-after: avoid; }
  .cv-p { font-size: 0.9em; line-height: 1.65; color: #141414; margin: 0 0 0.5em; }
  .cv-p:last-child { margin-bottom: 0; }
  .cv-inline { font-size: 0.88em; line-height: 1.75; color: #141414; margin: 0; }
  .cv-edu { margin-bottom: 0.45em; }
  .cv-xp { margin-bottom: 1.15em; }
  .cv-xp:last-child { margin-bottom: 0; }
  .cv-xp-top { display: flex; justify-content: space-between; gap: 1em; align-items: baseline; }
  .cv-xp-role { font-weight: 700; font-size: 0.95em; color: #000; }
  .cv-xp-date { font-size: 0.78em; color: #444; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .cv-xp-org { font-size: 0.84em; color: #0f5c5a; font-weight: 600; margin: 0.1em 0 0.35em; }
  .cv-xp, .cv-edu { break-inside: avoid; }
  /* mark = preview-only highlight; neutralize if it ever reaches print */
  .cv-doc mark { background: transparent; color: inherit; }

  /* --- Template: Classique (serif, centered, burgundy) --- */
  .cv-t-classic { font-family: Georgia, "Times New Roman", serif; }
  .cv-t-classic .cv-head { text-align: center; border-bottom: 3px double #141414; }
  .cv-t-classic .cv-name { letter-spacing: 0.04em; }
  .cv-t-classic .cv-role { color: #7a1f2b; letter-spacing: 0.3em; }
  .cv-t-classic .cv-contact-row { justify-content: center; }
  .cv-t-classic .cv-row { grid-template-columns: 1fr; gap: 0.5em; }
  .cv-t-classic .cv-label { color: #141414; border-bottom: 1px solid #141414; padding-bottom: 0.3em; font-size: 0.78em; }
  .cv-t-classic .cv-xp-org { color: #7a1f2b; }

  /* --- Template: Moderne (blue accent, stacked sections, rail) --- */
  .cv-t-modern .cv-head { border-bottom: none; padding-bottom: 0.9em; }
  .cv-t-modern .cv-name { font-family: "Segoe UI", system-ui, sans-serif; color: #122033; letter-spacing: -0.01em; }
  .cv-t-modern .cv-role {
    display: inline-block; background: #2563eb; color: #fff; padding: 0.35em 0.9em;
    border-radius: 999px; letter-spacing: 0.12em; margin-top: 0.7em;
  }
  .cv-t-modern .cv-row { grid-template-columns: 1fr; gap: 0.45em; border-bottom: none; padding: 0.9em 0; }
  .cv-t-modern .cv-label { color: #2563eb; }
  .cv-t-modern .cv-body { border-left: 3px solid #e3ecfd; padding-left: 1.2em; }
  .cv-t-modern .cv-xp-org { color: #2563eb; }
  .cv-t-modern .cv-xp-date { color: #2563eb; background: #eef4ff; padding: 0.1em 0.5em; border-radius: 6px; }

  /* --- Template: Compact (dense, monochrome, ATS-plain) --- */
  .cv-t-compact { font-size: 11.5px; }
  .cv-t-compact .cv-name { font-size: 1.9em; font-family: "Segoe UI", system-ui, sans-serif; }
  .cv-t-compact .cv-role { color: #444; letter-spacing: 0.14em; }
  .cv-t-compact .cv-head { padding-bottom: 0.8em; }
  .cv-t-compact .cv-row { padding: 0.65em 0; gap: 1.1em; }
  .cv-t-compact .cv-label { color: #444; }
  .cv-t-compact .cv-p { line-height: 1.45; }
  .cv-t-compact .cv-xp { margin-bottom: 0.6em; }
  .cv-t-compact .cv-xp-org { color: #333; }

  @page { margin: 1.4cm 1.5cm; }
`;

export function printHtml(html, title) {
  if (!html) return;
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '100%';
  iframe.style.bottom = '100%';
  iframe.setAttribute('aria-hidden', 'true');
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  doc.open();
  doc.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>`
    + `<style>${PRINT_CSS}</style></head><body>${html}</body></html>`,
  );
  doc.close();
  // Give the iframe a beat to lay out fonts before printing.
  setTimeout(() => {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    setTimeout(() => iframe.remove(), 2000);
  }, 300);
}
