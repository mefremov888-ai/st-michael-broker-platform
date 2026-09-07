import { IsOptional, IsUUID } from "class-validator";

export class InitiateBrokerCallDto {
  @IsUUID()
  clientId!: string;

  @IsOptional()
  @IsUUID()
  idempotencyKey?: string;
}
