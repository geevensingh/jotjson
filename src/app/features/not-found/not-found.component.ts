import { ChangeDetectionStrategy, Component, OnInit, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { AppHeaderComponent } from '../../shared/components/app-header/app-header.component';
import { SeoService } from '../../core/seo/seo.service';

@Component({
  selector: 'app-not-found',
  standalone: true,
  imports: [RouterLink, MatButtonModule, AppHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './not-found.component.html',
  styleUrl: './not-found.component.scss',
})
export class NotFoundComponent implements OnInit {
  private readonly seo = inject(SeoService);

  readonly attemptedSlug: string | undefined = this.readAttemptedSlug();

  ngOnInit(): void {
    // A 404 page should never be indexed, regardless of prior page state.
    this.seo.clearBlobTags();
    this.seo.setNoindex(true);
  }

  private readAttemptedSlug(): string | undefined {
    if (typeof history === 'undefined') return undefined;
    const state = history.state as { attemptedSlug?: unknown } | null;
    const slug = state?.attemptedSlug;
    return typeof slug === 'string' && slug.length > 0 ? slug : undefined;
  }
}
