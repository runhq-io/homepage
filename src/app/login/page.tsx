export default function LoginPage() {
  return (
    <div className="min-h-screen overflow-x-hidden">
      <div className="bw-animated-bg" aria-hidden="true" />

      <div className="relative z-10 min-h-screen flex flex-col">
        <main className="flex-1 flex items-center justify-center px-4">
          <div className="max-w-md w-full space-y-6 p-8 bg-slate-800/90 rounded-xl shadow-2xl border border-slate-700 text-center">
            <h1 className="text-3xl font-bold text-white">Fishtank</h1>
            <p className="text-slate-400">
              This is an internal admin console.
            </p>
            <p className="text-slate-300">
              Looking for the Fishtank app?
            </p>
            <a
              href="https://app.fishtank.bot"
              className="inline-block px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              Go to app.fishtank.bot
            </a>
          </div>
        </main>
      </div>
    </div>
  );
}
