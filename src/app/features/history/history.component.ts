import { Component } from '@angular/core';

@Component({
  selector: 'app-history',
  standalone: true,
  template: `
    <main>
      <h1>History</h1>
      <p class="note">Implementation in Milestone 5 (History).</p>
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
export class HistoryComponent {}
