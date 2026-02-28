import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import GitHub from 'next-auth/providers/github';
import { db, users } from '@/db';
import { eq } from 'drizzle-orm';

import { isAdminByEmail } from './adminPolicy';

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true, // Allow any host in production
  cookies: {
    pkceCodeVerifier: {
      name: '__Secure-authjs.pkce.code_verifier',
      options: {
        httpOnly: true,
        sameSite: 'none',
        path: '/',
        secure: true,
        maxAge: 900,
      },
    },
    state: {
      name: '__Secure-authjs.state',
      options: {
        httpOnly: true,
        sameSite: 'none',
        path: '/',
        secure: true,
        maxAge: 900,
      },
    },
    nonce: {
      name: '__Secure-authjs.nonce',
      options: {
        httpOnly: true,
        sameSite: 'none',
        path: '/',
        secure: true,
        maxAge: 900,
      },
    },
  },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          prompt: 'select_account',
          access_type: 'online',
        },
      },
    }),
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ user, account }) {
      if (!user.email) return false;

      // Check if user exists in our database
      const existingUsers = await db
        .select()
        .from(users)
        .where(eq(users.email, user.email))
        .limit(1);

	      if (existingUsers.length === 0) {
        // Create new user
        await db.insert(users).values({
          email: user.email,
          name: user.name,
          avatarUrl: user.image,
          authProvider: account?.provider,
          authProviderId: account?.providerAccountId,
          lastLoginAt: new Date(),
        });
      } else {
        // Update existing user and track login time
        await db
          .update(users)
          .set({
            name: user.name,
            avatarUrl: user.image,
            authProvider: account?.provider,
            authProviderId: account?.providerAccountId,
            lastLoginAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(users.email, user.email));
      }

      return true;
    },
	    async jwt({ token, user, account, trigger }) {
      if (user?.email) {
        (token as any).email = user.email;
      }
      if (account?.provider) {
        (token as any).authProvider = account.provider;
      }

      // On initial sign-in, persist user data to token.
      if (user?.email) {
        const dbUsers = await db.select().from(users).where(eq(users.email, user.email)).limit(1);
        if (dbUsers.length > 0) {
          const dbUser = dbUsers[0];
          token.id = dbUser.id;
          token.isActivated = dbUser.isActivated ?? false;
        }
        // Check admin_users table
        (token as any).isAdmin = await isAdminByEmail(user.email);
      }

      // On session update, re-fetch isActivated status from database
      if (trigger === 'update' && token.id) {
        const dbUsers = await db.select({ isActivated: users.isActivated }).from(users).where(eq(users.id, token.id as string)).limit(1);
        if (dbUsers.length > 0) {
          token.isActivated = dbUsers[0].isActivated ?? false;
        }
      }

      return token;
    },
    async session({ session, token }) {
	      // Use cached data from JWT token - no database calls needed!
	      if (token) {
	        (session.user as any).id = token.id;
	        (session.user as any).isActivated = token.isActivated;
		        (session.user as any).authProvider = (token as any)?.authProvider;
	      }
      (session.user as any).isAdmin = (token as any)?.isAdmin ?? false;
      return session;
    },
  },
  pages: {
    signIn: '/login',
  },
});
