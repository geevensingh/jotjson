import { Component } from '@angular/core';

@Component({
  selector: 'app-formatting-rules',
  standalone: true,
  template: `
    <main>
      <h1 i18n="@@formattingRules.title">Formatting Rules</h1>
      <p class="note" i18n="@@formattingRules.note">
        Implementation in Milestone 6 (Formatting rules).
      </p>
    </main>
  `,
  styles: [
    `
      main {
        max-width: 720px;
        margin: 4rem auto;
        padding: 0 1.5rem;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      }
      .note {
        color: #888;
      }
    `
  ]
})
export class FormattingRulesComponent {}
