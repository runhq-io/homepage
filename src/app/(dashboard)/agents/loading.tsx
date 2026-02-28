export default function AgentsLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-8 w-32 bg-slate-700 rounded mb-8" />
      <div className="bg-slate-800 rounded-lg p-6 space-y-4">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-12 bg-slate-700 rounded" />
        ))}
      </div>
    </div>
  );
}
