export type DirectoryView = 'grid' | 'list';

export type DirectoryUrlState = {
  search: string;
  tag: string | null;
  page: number;
  view: DirectoryView | null;
  captureMoment: boolean;
};

export function readDirectoryUrl(params: URLSearchParams): DirectoryUrlState {
  const rawPage = params.get('page') || '';
  const page = /^\d+$/u.test(rawPage) && Number.isSafeInteger(Number(rawPage))
    ? Math.max(1, Number(rawPage)) : 1;
  const rawView = params.get('view');
  return {
    search: (params.get('search') || '').slice(0, 200),
    tag: params.get('tag') || null,
    page,
    view: rawView === 'grid' || rawView === 'list' ? rawView : null,
    captureMoment: params.get('intent') === 'log',
  };
}

export function updateDirectoryUrl(href: string, patch: Partial<Pick<DirectoryUrlState, 'search' | 'tag' | 'page' | 'view'>>) {
  const url = new URL(href);
  if (patch.search !== undefined) {
    const search = patch.search.trim().slice(0, 200);
    if (search) url.searchParams.set('search', search);
    else url.searchParams.delete('search');
  }
  if (patch.tag !== undefined) {
    if (patch.tag) url.searchParams.set('tag', patch.tag);
    else url.searchParams.delete('tag');
  }
  if (patch.page !== undefined) {
    if (patch.page > 1) url.searchParams.set('page', String(patch.page));
    else url.searchParams.delete('page');
  }
  if (patch.view !== undefined) {
    if (patch.view) url.searchParams.set('view', patch.view);
    else url.searchParams.delete('view');
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
