export default function SettingsLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-8 w-32 bg-slate-700 rounded mb-8" />
      <div className="max-w-2xl space-y-6">
        {[1, 2, 3].map((i) => (
          <div key={i} className="bg-slate-800 rounded-lg p-6">
            <div className="h-4 w-24 bg-slate-700 rounded mb-3" />
            <div className="h-10 bg-slate-700 rounded" />
          </div>
        ))}
        <div className="h-10 w-32 bg-slate-700 rounded" />
      </div>
    </div>
  );
}
