export default function MigrationsLoading() {
  return (
    <div className="space-y-8">
      <div>
        <div className="h-8 w-72 bg-slate-700 rounded mb-3 animate-pulse" />
        <div className="h-4 w-full max-w-2xl bg-slate-800 rounded animate-pulse" />
      </div>

      {[...Array(2)].map((_, sectionIdx) => (
        <div key={sectionIdx}>
          <div className="h-6 w-48 bg-slate-700 rounded mb-2 animate-pulse" />
          <div className="h-4 w-72 bg-slate-800 rounded mb-4 animate-pulse" />
          <div className="bg-slate-800 rounded-lg overflow-hidden border border-slate-700/50">
            <div className="animate-pulse">
              <div className="h-12 bg-slate-700/50" />
              {[...Array(3)].map((_, i) => (
                <div
                  key={i}
                  className="h-16 border-t border-slate-700 px-4 py-3 flex items-center gap-4"
                >
                  <div className="h-4 w-48 bg-slate-700 rounded" />
                  <div className="h-4 w-32 bg-slate-700 rounded" />
                  <div className="h-4 w-24 bg-slate-700 rounded" />
                  <div className="h-4 w-20 bg-slate-700 rounded ml-auto" />
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
