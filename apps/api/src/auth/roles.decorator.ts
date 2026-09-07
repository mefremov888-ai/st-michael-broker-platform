import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@st-michael/shared';

export const Roles = (...roles: UserRole[]) => SetMetadata('roles', roles);