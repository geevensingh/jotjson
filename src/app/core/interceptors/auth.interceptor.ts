import { HttpInterceptorFn } from '@angular/common/http';

// Placeholder: real auth-token attachment will be wired up in Milestone 3 (Auth integration).
export const authInterceptor: HttpInterceptorFn = (req, next) => next(req);
