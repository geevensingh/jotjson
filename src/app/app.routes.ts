import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';
import { shareBlobResolver } from './features/share/share-blob.resolver';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/home/home.component').then((m) => m.HomeComponent),
    title: 'JotJSON - Input, store, and display JSON'
  },
  {
    path: 's/:slug',
    loadComponent: () =>
      import('./features/home/home.component').then((m) => m.HomeComponent),
    resolve: { initialBlob: shareBlobResolver },
    title: 'Shared JSON - JotJSON'
  },
  {
    path: 'history',
    loadComponent: () =>
      import('./features/history/history.component').then((m) => m.HistoryComponent),
    canActivate: [authGuard],
    title: 'History - JotJSON'
  },
  {
    path: 'formatting-rules',
    loadComponent: () =>
      import('./features/formatting-rules/formatting-rules.component').then(
        (m) => m.FormattingRulesComponent
      ),
    title: 'Formatting Rules - JotJSON'
  },
  {
    path: 'profile',
    loadComponent: () =>
      import('./features/profile/profile.component').then((m) => m.ProfileComponent),
    canActivate: [authGuard],
    title: 'Profile - JotJSON'
  },
  {
    path: '404',
    loadComponent: () =>
      import('./features/not-found/not-found.component').then(
        (m) => m.NotFoundComponent
      ),
    title: 'Not found - JotJSON'
  },
  { path: '**', redirectTo: '/404' }
];
