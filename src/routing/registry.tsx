import type { ComponentType, ReactNode } from 'react';
import { lazyWithRetry } from './lazyWithRetry';
import DetailsSkeleton from '../components/skeletons/DetailsSkeleton';
import GridSkeleton from '../components/skeletons/GridSkeleton';
import GenreSkeleton from '../components/skeletons/GenreSkeleton';

export type RouteEntry = {
  path: string;
  loader: (opts?: { silent?: boolean }) => Promise<{ default: ComponentType<unknown> }>;
  fallback?: ReactNode;
  guard?: 'private';
};

const lz = <P extends object>(loader: () => Promise<{ default: ComponentType<P> }>) =>
  (opts?: { silent?: boolean }) => lazyWithRetry(loader, opts) as Promise<{ default: ComponentType<unknown> }>;

export const ROUTES: RouteEntry[] = [
  // Catalog grids
  { path: '/movies',                  loader: lz(() => import('../pages/Movies')),                  fallback: <GridSkeleton /> },
  { path: '/anime',                   loader: lz(() => import('../pages/Anime')),                   fallback: <GridSkeleton /> },
  { path: '/tv-shows',                loader: lz(() => import('../pages/TVShows')),                 fallback: <GridSkeleton /> },
  { path: '/collections',             loader: lz(() => import('../pages/Collections')),             fallback: <GridSkeleton /> },
  { path: '/list-catalog',            loader: lz(() => import('../pages/SharedListsCatalogPage')),  fallback: <GridSkeleton /> },
  { path: '/watchparty/list',         loader: lz(() => import('../pages/WatchPartyList')),          fallback: <GridSkeleton /> },
  { path: '/wishboard',               loader: lz(() => import('../pages/Greenlight/WishboardPage')), fallback: <GridSkeleton /> },
  { path: '/vip/invoices',            loader: lz(() => import('../pages/VipInvoicesPage')),         fallback: <GridSkeleton /> },
  { path: '/ftv',                     loader: lz(() => import('../pages/FranceTV/FranceTVBrowse')), fallback: <GridSkeleton /> },
  { path: '/top10',                   loader: lz(() => import('../pages/Top10Page')),               fallback: <GridSkeleton /> },
  { path: '/calendar',                loader: lz(() => import('../pages/CalendarPage')) },

  // Provider catalogs
  { path: '/provider/:providerId',                          loader: lz(() => import('../pages/ProviderContent')),       fallback: <GridSkeleton /> },
  { path: '/provider/:providerId/:type',                    loader: lz(() => import('../pages/ProviderCatalogPage')),   fallback: <GridSkeleton /> },
  { path: '/provider/:providerId/:type/:genreId',           loader: lz(() => import('../pages/ProviderCatalogPage')),   fallback: <GridSkeleton /> },

  // Details pages
  { path: '/movie/:id',               loader: lz(() => import('../pages/MovieDetails')),            fallback: <DetailsSkeleton /> },
  { path: '/tv/:id',                  loader: lz(() => import('../pages/TVDetails')),               fallback: <DetailsSkeleton /> },
  { path: '/collection/:id',          loader: lz(() => import('../pages/CollectionDetails')),       fallback: <DetailsSkeleton /> },
  { path: '/person/:id',              loader: lz(() => import('../pages/PersonDetails')),           fallback: <DetailsSkeleton /> },
  { path: '/list/:shareCode',         loader: lz(() => import('../pages/SharedListPage')),          fallback: <DetailsSkeleton /> },

  // Genre
  { path: '/genre/:mediaType/:genreId', loader: lz(() => import('../pages/GenrePage')),             fallback: <GenreSkeleton /> },

  // Search
  { path: '/search',                  loader: lz(() => import('../pages/Search')) },

  // Watch routes (no skeleton — RouteProgressBar fallback)
  { path: '/watch/movie/:tmdbid',                         loader: lz(() => import('../pages/Watch/WatchMovie')) },
  { path: '/watch/tv/:tmdbid/s/:season/e/:episode',       loader: lz(() => import('../pages/Watch/WatchTv')) },
  { path: '/watch/anime/:id/season/:season/episode/:episode', loader: lz(() => import('../pages/Watch/WatchAnime')) },
  { path: '/live-tv',                 loader: lz(() => import('../pages/LiveTV')) },
  { path: '/ftv/info/:encoded',       loader: lz(() => import('../pages/FranceTV/FranceTVInfo')) },
  { path: '/ftv/watch/:encoded',      loader: lz(() => import('../pages/FranceTV/FranceTVPlayer')) },

  // Watch party
  { path: '/watchparty/create',       loader: lz(() => import('../pages/WatchPartyCreate')) },
  { path: '/watchparty/room/:roomId', loader: lz(() => import('../pages/WatchPartyRoom')) },
  { path: '/watchparty/join',         loader: lz(() => import('../pages/WatchPartyJoin')) },
  { path: '/watchparty/join/:code',   loader: lz(() => import('../pages/WatchPartyJoin')) },

  // Auth & profile
  { path: '/auth',                    loader: lz(() => import('../components/DiscordAuth')) },
  { path: '/auth/google',             loader: lz(() => import('../components/GoogleAuth')) },
  { path: '/oauth/authorize',         loader: lz(() => import('../pages/OAuthAuthorizePage')) },
  { path: '/profile',                 loader: lz(() => import('../pages/Profile')), guard: 'private' },
  { path: '/profile-management',      loader: lz(() => import('../pages/ProfileManagement')) },
  { path: '/alerts',                  loader: lz(() => import('../pages/AlertsPage')) },

  // Greenlight
  { path: '/wishboard/new',           loader: lz(() => import('../pages/Greenlight/WishboardNewRequest')) },
  { path: '/wishboard/my-requests',   loader: lz(() => import('../pages/Greenlight/WishboardUserRequests')) },
  { path: '/wishboard/submit-link',   loader: lz(() => import('../pages/Greenlight/SubmitLinkPage')) },

  // VIP
  { path: '/vip',                     loader: lz(() => import('../pages/VipPage')) },
  { path: '/vip/don',                 loader: lz(() => import('../pages/VipDonatePage')) },
  { path: '/vip/invoice/:publicId',   loader: lz(() => import('../pages/VipInvoicePage')) },
  { path: '/vip/cadeau/:giftToken',   loader: lz(() => import('../pages/VipGiftPage')) },

  // Other
  { path: '/about',                   loader: lz(() => import('../pages/WhatIsMovixPage')) },
  { path: '/help/*',                  loader: lz(() => import('../pages/help/HelpRouter')) },
  { path: '/privacy',                 loader: lz(() => import('../pages/Privacy')) },
  { path: '/terms-of-service',        loader: lz(() => import('../pages/TermsOfService')) },
  { path: '/cinegraph',               loader: lz(() => import('../pages/CineGraph')) },
  { path: '/settings',                loader: lz(() => import('../pages/SettingsPage')) },
  { path: '/wrapped',                 loader: lz(() => import('../pages/WrappedPage')) },
  { path: '/wrapped/:year',           loader: lz(() => import('../pages/WrappedPage')) },
  { path: '/dmca',                    loader: lz(() => import('../pages/DMCA')) },
  { path: '/frais',                   loader: lz(() => import('../pages/CostsPage')) },
  { path: '/admin',                   loader: lz(() => import('../pages/AdminPage')) },
  { path: '/download/:type/:id',      loader: lz(() => import('../pages/DownloadPage')) },
  { path: '/debrid',                  loader: lz(() => import('../pages/DebridPage')) },
  { path: '/roulette',                loader: lz(() => import('../pages/RoulettePage')) },
  { path: '/suggestion',              loader: lz(() => import('../pages/SuggestionPage')) },
  { path: '/extension',               loader: lz(() => import('../pages/ExtensionPage')) },
  { path: '/app',                     loader: lz(() => import('../pages/AppDownloadPage')) },
];
