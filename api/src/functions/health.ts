import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

export async function health(
  _req: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  context.log('health check');
  return {
    status: 200,
    jsonBody: {
      status: 'ok',
      service: 'jotjson-api',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    },
  };
}

app.http('health', {
  methods: ['GET'],
  route: 'health',
  authLevel: 'anonymous',
  handler: health,
});
