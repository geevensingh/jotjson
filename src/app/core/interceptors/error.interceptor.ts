import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { LoggerService } from '../telemetry/logger.service';
import { sanitizePath } from '../telemetry/normalize-error';

export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const logger = inject(LoggerService);
  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      // Never log `req.url` directly - it can include query strings
      // (history search `q`, continuation tokens). `sanitizePath`
      // strips the query and fragment.
      logger.warn('api.error', {
        method: req.method,
        pathTemplate: sanitizePath(req.url),
        status: err.status
      });
      return throwError(() => err);
    })
  );
};
