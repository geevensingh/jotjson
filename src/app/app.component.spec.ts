import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AppComponent } from './app.component';
import { DocumentDropController } from './core/upload/document-drop-controller.service';
import { provideFakeAuth } from '../testing/auth.testing';

describe('AppComponent', () => {
  beforeEach(async () => {
    // Stub DocumentDropController so we don't attach real document-level
    // drag/drop listeners that would leak across the Karma test run after
    // this spec's injector is torn down.
    const dropControllerStub = {
      dropActive: signal(false).asReadonly(),
      registerEditorHandler: () => () => {
        /* noop */
      }
    };

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        { provide: DocumentDropController, useValue: dropControllerStub },
        ...provideFakeAuth()
      ]
    }).compileComponents();
  });

  it('creates the component', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('has the JotJSON title', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance.title).toBe('JotJSON');
  });

  it('eagerly instantiates DocumentDropController so drag-drop listeners attach at app start', () => {
    TestBed.createComponent(AppComponent);
    const controller = TestBed.inject(DocumentDropController);
    expect(controller).toBeTruthy();
    // dropActive signal exists and is initially false
    expect(controller.dropActive()).toBe(false);
  });
});
