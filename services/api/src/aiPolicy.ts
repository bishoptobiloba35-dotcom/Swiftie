export type AiPlan = "BASIC" | "PREMIUM";
export type BusinessMemberRole = "OWNER" | "ADMIN" | "DISPATCHER" | "VIEWER";

export function canUseAiAction(plan: AiPlan): boolean {
  return plan === "PREMIUM";
}

export function canCreatePersonalBuyOrder(role: string): boolean {
  return role === "CUSTOMER";
}

export function canManageBusiness(role: string): boolean {
  return role === "CUSTOMER" || role === "ADMIN";
}

export function canDispatchBusiness(role: BusinessMemberRole): boolean {
  return role === "OWNER" || role === "ADMIN" || role === "DISPATCHER";
}
