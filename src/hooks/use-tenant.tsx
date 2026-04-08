"use client";

import { createContext, useContext, ReactNode } from "react";

interface TenantContextType {
  locationId: string;
  companyId: string;
  locationName: string;
  userId: string;
}

const TenantContext = createContext<TenantContextType | null>(null);

export function TenantProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: TenantContextType;
}) {
  return (
    <TenantContext.Provider value={value}>{children}</TenantContext.Provider>
  );
}

export function useTenant() {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error("useTenant deve ser usado dentro de um TenantProvider");
  }
  return context;
}
