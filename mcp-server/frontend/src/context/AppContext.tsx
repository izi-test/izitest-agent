import React, { createContext, useState, useContext, useCallback } from 'react';

interface AppContextType {
  toastMsg: string | null;
  toastType: 'success' | 'error';
  showToast: (msg: string, type?: 'success' | 'error') => void;
  view: 'List' | 'Detail' | 'Settings';
  setView: (view: 'List' | 'Detail' | 'Settings') => void;
  currentWorkflowName: string | null;
  setCurrentWorkflowName: (name: string | null) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [toastType, setToastType] = useState<'success' | 'error'>('success');
  const [view, setView] = useState<'List' | 'Detail' | 'Settings'>('List');
  const [currentWorkflowName, setCurrentWorkflowName] = useState<string | null>(null);

  const showToast = useCallback((msg: string, type: 'success' | 'error' = 'success') => {
    setToastMsg(msg);
    setToastType(type);
    setTimeout(() => setToastMsg(null), 2500);
  }, []);

  return (
    <AppContext.Provider value={{ toastMsg, toastType, showToast, view, setView, currentWorkflowName, setCurrentWorkflowName }}>
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useAppContext must be used within an AppProvider');
  return context;
}
