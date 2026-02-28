export default function DashboardLoading() {
  return (
    <div className="animate-pulse">
      <div className="h-8 w-48 bg-slate-700 rounded mb-8" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <div className="bg-slate-800 rounded-lg p-6 h-24" />
        <div className="bg-slate-800 rounded-lg p-6 h-24" />
      </div>
      <div className="bg-slate-800 rounded-lg p-6 h-32" />
    </div>
  );
}
