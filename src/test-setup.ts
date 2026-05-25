import { setupTestBed } from '@analogjs/vitest-angular/setup-testbed';
import '@analogjs/vitest-angular/setup-zone';
import '@angular/compiler';

setupTestBed({
  zoneless: false,
});
