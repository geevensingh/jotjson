import { Component, Input } from '@angular/core';

@Component({
  selector: 'app-share',
  standalone: true,
  template: `
    <main>
      <h1>Shared JSON</h1>
      <p>Slug: <code>{{ slug }}</code></p>
      <p class="note">Implementation in Milestone 4 (Persistent links).</p>
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
export class ShareComponent {
  @Input() slug = '';
}
