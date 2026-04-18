import { Component } from '@angular/core';

@Component({
  selector: 'app-home',
  standalone: true,
  template: `
    <main class="home">
      <h1>JotJSON</h1>
      <p>Input, store, and display JSON.</p>
      <p class="note">Milestone 1 scaffold — editor and tree view coming in Milestone 2.</p>
    </main>
  `,
  styles: [
    `
      .home {
        max-width: 720px;
        margin: 4rem auto;
        padding: 0 1.5rem;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      }
      h1 {
        font-weight: 400;
      }
      h1::after {
        content: 'JSON';
        font-weight: 700;
      }
      h1 {
        font-size: 3rem;
        margin-bottom: 0.5rem;
      }
      .note {
        color: #888;
        font-size: 0.9rem;
      }
    `
  ]
})
export class HomeComponent {}
