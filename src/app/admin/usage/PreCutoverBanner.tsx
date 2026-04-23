interface Props {
  totalCents: number;
}

export function PreCutoverBanner({ totalCents }: Props) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
      <strong className="text-amber-100">Historical data:</strong> the selected range includes{' '}
      <span className="tabular-nums">${(totalCents / 100).toFixed(2)}</span>{' '}
      of pre-migration usage (monthly rollups only — daily breakdown not available for
      these periods).
    </div>
  );
}
