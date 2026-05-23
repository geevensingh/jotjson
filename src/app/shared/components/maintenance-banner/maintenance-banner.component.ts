import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  PLATFORM_ID,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';

type MaintenanceBannerData = {
  active: boolean;
  message: string;
};

const MAINTENANCE_BANNER_ASSET_URL = '/assets/maintenance-banner.json';

@Component({
  selector: 'jj-maintenance-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './maintenance-banner.component.html',
  styleUrl: './maintenance-banner.component.scss',
})
export class MaintenanceBannerComponent {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  protected readonly bannerData = signal<MaintenanceBannerData | null>(null);
  protected readonly activeMessage = computed(() => {
    const maintenanceBanner = this.bannerData();
    return maintenanceBanner?.active ? maintenanceBanner.message : '';
  });

  constructor() {
    if (this.isBrowser) {
      this.loadBanner();
    }
  }

  private loadBanner(): void {
    this.http
      .get<MaintenanceBannerData>(MAINTENANCE_BANNER_ASSET_URL)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() => of(null)),
      )
      .subscribe((maintenanceBanner) => {
        this.bannerData.set(maintenanceBanner);
      });
  }
}
