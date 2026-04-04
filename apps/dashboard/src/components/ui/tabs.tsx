"use client";

import { useState, createContext, useContext, type ReactNode } from "react";

interface TabsContextValue {
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext() {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("Tabs components must be used within <Tabs>");
  return ctx;
}

interface TabsProps {
  defaultTab: string;
  children: ReactNode;
}

export function Tabs({ defaultTab, children }: TabsProps) {
  const [activeTab, setActiveTab] = useState(defaultTab);
  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab }}>
      <div>{children}</div>
    </TabsContext.Provider>
  );
}

interface TabListProps {
  children: ReactNode;
}

export function TabList({ children }: TabListProps) {
  return (
    <div className="flex border-b border-gray-200 gap-0" role="tablist">
      {children}
    </div>
  );
}

interface TabTriggerProps {
  value: string;
  children: ReactNode;
}

export function TabTrigger({ value, children }: TabTriggerProps) {
  const { activeTab, setActiveTab } = useTabsContext();
  const isActive = activeTab === value;

  return (
    <button
      role="tab"
      aria-selected={isActive}
      onClick={() => setActiveTab(value)}
      className={`
        px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px
        ${isActive
          ? "border-blue-600 text-blue-600"
          : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
        }
      `}
    >
      {children}
    </button>
  );
}

interface TabContentProps {
  value: string;
  children: ReactNode;
}

export function TabContent({ value, children }: TabContentProps) {
  const { activeTab } = useTabsContext();
  if (activeTab !== value) return null;
  return (
    <div role="tabpanel" className="pt-4">
      {children}
    </div>
  );
}
