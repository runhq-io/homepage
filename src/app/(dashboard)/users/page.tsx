import { auth } from '@/lib/auth';
import { db, users, adminUsers } from '@/db';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

async function getUsers() {
  const [allUsers, allAdmins] = await Promise.all([
    db.select().from(users).orderBy(users.createdAt),
    db.select({ userId: adminUsers.userId }).from(adminUsers),
  ]);
  const adminUserIds = new Set(allAdmins.map((a) => a.userId));
  return allUsers.map((user) => ({
    ...user,
    isAdmin: adminUserIds.has(user.id),
  }));
}

export default async function UsersPage() {
  const session = await auth();
  const user = session?.user as any;

  if (!user?.isAdmin) {
    redirect('/');
  }

  const allUsers = await getUsers();

  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-8">Users</h1>

      <div className="bg-slate-800 rounded-lg overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-700">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-300 uppercase tracking-wider">
                User
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-300 uppercase tracking-wider">
                Email
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-300 uppercase tracking-wider">
                Provider
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-300 uppercase tracking-wider">
                Role
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-300 uppercase tracking-wider">
                Created
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {allUsers.map((user) => (
              <tr key={user.id} className="hover:bg-slate-750">
                <td className="px-6 py-4 whitespace-nowrap">
                  <Link href={`/users/${user.id}`} className="flex items-center gap-3 hover:text-blue-400">
                    {user.avatarUrl ? (
                      <img
                        src={user.avatarUrl}
                        alt=""
                        className="h-8 w-8 rounded-full"
                      />
                    ) : (
                      <div className="h-8 w-8 rounded-full bg-slate-600 flex items-center justify-center text-slate-300">
                        {user.name?.charAt(0) || '?'}
                      </div>
                    )}
                    <span className="text-white font-medium">{user.name || 'Unknown'}</span>
                  </Link>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-slate-300">
                  {user.email}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-slate-300 capitalize">
                  {user.authProvider || '-'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  {user.isAdmin ? (
                    <span className="px-2 py-1 text-xs font-medium bg-blue-600 text-white rounded">
                      Admin
                    </span>
                  ) : (
                    <span className="px-2 py-1 text-xs font-medium bg-slate-600 text-slate-300 rounded">
                      User
                    </span>
                  )}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-slate-400 text-sm">
                  {new Date(user.createdAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {allUsers.length === 0 && (
          <div className="px-6 py-8 text-center text-slate-400">
            No users found
          </div>
        )}
      </div>
    </div>
  );
}
