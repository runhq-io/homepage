interface Props {
  totalCents: number;
}

export function PreCutoverBanner({ totalCents }: Props) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <strong>Historical data:</strong> the selected range includes{' '}
      <span className="tabular-nums">${(totalCents / 100).toFixed(2)}</span>{' '}
      of pre-migration usage (monthly rollups only — daily breakdown not available for
      these periods).
    </div>
  );
}
