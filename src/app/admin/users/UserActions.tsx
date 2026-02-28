'use client';

import { useState, useRef, useEffect } from 'react';
import { toggleUserActivation, deleteUser } from './actions';

interface UserActionsProps {
  userId: string;
  isActivated: boolean;
  userName: string | null;
}

export function UserActions({ userId, isActivated, userName }: UserActionsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleToggleActivation = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setLoading('activation');
    try {
      await toggleUserActivation(userId);
    } catch (error) {
      console.error('Failed to toggle activation:', error);
    }
    setLoading(null);
    setIsOpen(false);
  };

  const handleDeleteUser = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setLoading('delete');
    try {
      await deleteUser(userId);
    } catch (error) {
      console.error('Failed to delete user:', error);
    }
    setLoading(null);
    setIsOpen(false);
    setConfirmDelete(false);
  };

  const handleDropdownClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsOpen(!isOpen);
    setConfirmDelete(false);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={handleDropdownClick}
        className="p-1 hover:bg-slate-600 rounded transition-colors"
        title="Actions"
      >
        <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
        </svg>
      </button>

      {isOpen && (
        <div className="absolute right-0 top-8 z-50 w-48 bg-slate-700 border border-slate-600 rounded-lg shadow-xl py-1">
          {/* Activation toggle */}
          <button
            onClick={handleToggleActivation}
            disabled={loading === 'activation'}
            className="w-full px-4 py-2 text-left text-sm hover:bg-slate-600 flex items-center gap-2 disabled:opacity-50"
          >
            {loading === 'activation' ? (
              <span className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
            ) : isActivated ? (
              <span className="w-4 h-4 text-red-400">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
              </span>
            ) : (
              <span className="w-4 h-4 text-green-400">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </span>
            )}
            <span className={isActivated ? 'text-red-300' : 'text-green-300'}>
              {isActivated ? 'Deactivate' : 'Activate'}
            </span>
          </button>

          {/* Delete user */}
          <button
            onClick={handleDeleteUser}
            disabled={loading === 'delete'}
            className="w-full px-4 py-2 text-left text-sm hover:bg-slate-600 flex items-center gap-2 disabled:opacity-50"
          >
            {loading === 'delete' ? (
              <span className="w-4 h-4 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
            ) : (
              <span className="w-4 h-4 text-red-400">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </span>
            )}
            <span className="text-red-300">
              {confirmDelete ? `Confirm delete${userName ? ` "${userName}"` : ''}?` : 'Delete user'}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
