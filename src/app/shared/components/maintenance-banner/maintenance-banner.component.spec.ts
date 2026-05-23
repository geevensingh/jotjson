import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PLATFORM_ID } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MaintenanceBannerComponent } from './maintenance-banner.component';

type MaintenanceBannerData = {
  active: boolean;
  message: string;
};

const MAINTENANCE_BANNER_ASSET_URL = '/assets/maintenance-banner.json';

describe('MaintenanceBannerComponent', () => {
  let fixture: ComponentFixture<MaintenanceBannerComponent>;
  let httpMock: HttpTestingController;

  function setUp(platformId: 'browser' | 'server' = 'browser'): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [MaintenanceBannerComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: PLATFORM_ID, useValue: platformId },
      ],
    });
    fixture = TestBed.createComponent(MaintenanceBannerComponent);
    httpMock = TestBed.inject(HttpTestingController);
  }

  function banner(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.maintenance-banner');
  }

  function flushBannerData(maintenanceBanner: MaintenanceBannerData): void {
    httpMock.expectOne(MAINTENANCE_BANNER_ASSET_URL).flush(maintenanceBanner);
    fixture.detectChanges();
  }

  afterEach(() => {
    httpMock.verify();
  });

  it('renders nothing when bannerData()?.active is false', () => {
    setUp();

    flushBannerData({ active: false, message: 'Scheduled maintenance' });

    expect(banner()).toBeNull();
  });

  it('renders the message when bannerData()?.active is true', () => {
    setUp();

    flushBannerData({ active: true, message: 'Scheduled maintenance' });

    expect(banner()?.textContent?.trim()).toBe('Scheduled maintenance');
  });

  it('does not fetch on the server platform', () => {
    setUp('server');

    httpMock.expectNone(MAINTENANCE_BANNER_ASSET_URL);
    fixture.detectChanges();

    expect(banner()).toBeNull();
  });

  it('gracefully hides the banner when the HTTP request fails', () => {
    setUp();

    httpMock
      .expectOne(MAINTENANCE_BANNER_ASSET_URL)
      .flush('boom', { status: 500, statusText: 'Server Error' });

    expect(() => fixture.detectChanges()).not.toThrow();
    expect(banner()).toBeNull();
  });
});
