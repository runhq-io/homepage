export default function ServersLoading() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-8">Servers</h1>

      {/* Stats skeleton */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="bg-slate-800 rounded-lg p-4 animate-pulse">
            <div className="h-8 w-12 bg-slate-700 rounded mb-2" />
            <div className="h-4 w-16 bg-slate-700 rounded" />
          </div>
        ))}
      </div>

      {/* Table skeleton */}
      <div className="bg-slate-800 rounded-lg overflow-hidden">
        <div className="animate-pulse">
          <div className="h-12 bg-slate-700/50" />
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 border-t border-slate-700 px-4 py-3 flex items-center gap-4">
              <div className="h-4 w-48 bg-slate-700 rounded" />
              <div className="h-4 w-32 bg-slate-700 rounded" />
              <div className="h-4 w-20 bg-slate-700 rounded" />
              <div className="h-4 w-20 bg-slate-700 rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
