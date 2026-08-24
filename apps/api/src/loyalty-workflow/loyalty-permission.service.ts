import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "@st-michael/database";
import type { CurrentUserPayload } from "../auth/current-user.decorator";
import { LOYALTY_PERMISSIONS } from "./loyalty-workflow.dto";

export type LoyaltyPermission = (typeof LOYALTY_PERMISSIONS)[number];

const STAFF_ROLES = new Set(["ADMIN", "MANAGER"]);

@Injectable()
export class LoyaltyPermissionService {
  constructor(@Inject("PrismaClient") private readonly prisma: PrismaClient) {}

  requireStaff(user: CurrentUserPayload): void {
    if (!user?.id || !STAFF_ROLES.has(user.role)) {
      throw new ForbiddenException(
        "Loyalty workspace is available only to internal employees",
      );
    }
  }

  requireAdmin(user: CurrentUserPayload): void {
    if (!user?.id || user.role !== "ADMIN") {
      throw new ForbiddenException("Insufficient permissions");
    }
  }

  async require(
    user: CurrentUserPayload,
    permission: LoyaltyPermission,
  ): Promise<void> {
    this.requireStaff(user);
    if (user.role === "ADMIN") return;

    const grant = await (this.prisma as any).loyaltyUserGrant.findFirst({
      where: { userId: user.id, permission, revokedAt: null },
      select: { id: true },
    });
    if (!grant) throw new ForbiddenException("Insufficient permissions");
  }

  async requireAll(
    user: CurrentUserPayload,
    permissions: readonly LoyaltyPermission[],
  ): Promise<void> {
    this.requireStaff(user);
    if (user.role === "ADMIN") return;

    const required = Array.from(new Set(permissions));
    if (!required.length) return;

    const grants = await (this.prisma as any).loyaltyUserGrant.findMany({
      where: {
        userId: user.id,
        permission: { in: required },
        revokedAt: null,
      },
      select: { permission: true },
    });
    const granted = new Set(
      grants.map(
        (grant: { permission: LoyaltyPermission }) => grant.permission,
      ),
    );
    if (required.some((permission) => !granted.has(permission))) {
      throw new ForbiddenException("Insufficient permissions");
    }
  }

  async requireAny(
    user: CurrentUserPayload,
    permissions: readonly LoyaltyPermission[],
  ): Promise<void> {
    this.requireStaff(user);
    if (user.role === "ADMIN") return;

    const accepted = Array.from(new Set(permissions));
    if (!accepted.length)
      throw new ForbiddenException("Insufficient permissions");

    const grant = await (this.prisma as any).loyaltyUserGrant.findFirst({
      where: {
        userId: user.id,
        permission: { in: accepted },
        revokedAt: null,
      },
      select: { id: true },
    });
    if (!grant) throw new ForbiddenException("Insufficient permissions");
  }

  async effective(user: CurrentUserPayload) {
    this.requireStaff(user);
    if (user.role === "ADMIN") {
      return {
        role: user.role,
        permissions: [...LOYALTY_PERMISSIONS],
        defaults: {
          ownQueue: true,
          ownAttempts: true,
          ownTasks: true,
        },
      };
    }

    const rows = await (this.prisma as any).loyaltyUserGrant.findMany({
      where: { userId: user.id, revokedAt: null },
      select: { permission: true },
      orderBy: { permission: "asc" },
    });
    const granted = rows.map(
      (row: { permission: LoyaltyPermission }) => row.permission,
    );
    const permissions = LOYALTY_PERMISSIONS.filter((permission) =>
      granted.includes(permission),
    );
    return {
      role: user.role,
      permissions,
      defaults: {
        ownQueue:
          permissions.includes("READ_OWN_QUEUE") ||
          permissions.includes("CALL_EXECUTE"),
        ownAttempts: permissions.includes("CALL_EXECUTE"),
        ownTasks:
          permissions.includes("READ_OWN_QUEUE") ||
          permissions.includes("CALL_EXECUTE"),
      },
    };
  }
}
