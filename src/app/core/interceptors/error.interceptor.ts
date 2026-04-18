import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';

export const errorInterceptor: HttpInterceptorFn = (req, next) =>
  next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      // Error-toast wiring will land in the polish milestone; for now just rethrow.
      console.error('[API error]', req.method, req.url, err.status, err.message);
      return throwError(() => err);
    })
  );
