import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/home/home.component').then((m) => m.HomeComponent),
    title: 'JotJSON — Input, store, and display JSON'
  },
  {
    path: 's/:slug',
    loadComponent: () =>
      import('./features/share/share.component').then((m) => m.ShareComponent),
    title: 'Shared JSON — JotJSON'
  },
  {
    path: 'history',
    loadComponent: () =>
      import('./features/history/history.component').then((m) => m.HistoryComponent),
    title: 'History — JotJSON'
  },
  {
    path: 'formatting-rules',
    loadComponent: () =>
      import('./features/formatting-rules/formatting-rules.component').then(
        (m) => m.FormattingRulesComponent
      ),
    title: 'Formatting Rules — JotJSON'
  },
  {
    path: 'profile',
    loadComponent: () =>
      import('./features/profile/profile.component').then((m) => m.ProfileComponent),
    canActivate: [authGuard],
    title: 'Profile — JotJSON'
  },
  { path: '**', redirectTo: '' }
];
