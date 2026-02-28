export default function ServersLoading() {
  return (
    <div>
      {/* Header skeleton */}
      <div className="flex items-center justify-between mb-8">
        <div className="h-8 w-40 bg-slate-700 rounded animate-pulse" />
        <div className="h-10 w-36 bg-slate-700 rounded animate-pulse" />
      </div>

      {/* Project cards skeleton */}
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="bg-slate-800 rounded-lg p-5 animate-pulse">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-slate-700 rounded-lg" />
                <div>
                  <div className="h-5 w-32 bg-slate-700 rounded mb-2" />
                  <div className="h-4 w-48 bg-slate-700 rounded" />
                </div>
              </div>
              <div className="h-5 w-20 bg-slate-700 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
