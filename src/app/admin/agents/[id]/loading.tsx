export default function Loading() {
  return (
    <div className="animate-pulse">
      {/* Back link */}
      <div className="h-4 w-32 bg-slate-700 rounded mb-4"></div>

      {/* Header */}
      <div className="bg-slate-800 rounded-lg p-6 mb-8">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="h-8 w-64 bg-slate-700 rounded mb-2"></div>
            <div className="h-4 w-96 bg-slate-700 rounded mb-4"></div>
            <div className="h-3 w-48 bg-slate-700 rounded"></div>
          </div>
          <div className="flex gap-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="px-4 py-2 bg-slate-700 rounded-lg w-20 h-16"></div>
            ))}
          </div>
        </div>
      </div>

      {/* State Machine */}
      <div className="bg-slate-800 rounded-lg p-6 mb-8">
        <div className="h-6 w-48 bg-slate-700 rounded mb-2"></div>
        <div className="h-4 w-64 bg-slate-700 rounded mb-4"></div>
        <div className="h-12 bg-slate-700 rounded"></div>
      </div>

      {/* Table */}
      <div className="bg-slate-800 rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-700">
          <div className="h-6 w-32 bg-slate-700 rounded"></div>
        </div>
        <div className="divide-y divide-slate-700">
          {[1, 2, 3].map((i) => (
            <div key={i} className="px-6 py-4">
              <div className="h-4 bg-slate-700 rounded w-full"></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
