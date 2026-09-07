import { Controller, Post, Get, Patch, Body, Req, UseGuards, HttpCode, HttpStatus, UploadedFile, UseInterceptors, BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from './current-user.decorator';
import { registerDtoSchema, loginDtoSchema, phoneSchema, forgotPasswordDtoSchema, resetPasswordDtoSchema } from '@st-michael/shared';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register broker' })
  @ApiResponse({ status: 201, description: 'Broker registered, OTP sent' })
  async register(@Body() body: unknown, @Req() req: Request) {
    // 2026-06-26: вместо .parse() (бросает ZodError → 500) используем
    // .safeParse и преобразуем ВСЕ issues в массив { field, message } на
    // русском. UI получит сразу полный список ошибок и подсветит все
    // невалидные поля одновременно, а не по одной.
    const parsed = registerDtoSchema.safeParse(body);
    if (!parsed.success) {
      const ruByField: Record<string, string> = {
        phone: 'Введите корректный номер телефона',
        email: 'Введите корректный email',
        password: 'Пароль должен быть не менее 8 символов',
        inn: 'ИНН должен содержать 10 или 12 цифр',
        fullName: 'Введите ФИО (минимум 2 символа)',
        agencyName: 'Название агентства от 2 до 200 символов',
      };
      const errors = parsed.error.issues.map((issue) => {
        const field = String(issue.path[0] ?? '');
        return {
          field: field || undefined,
          message: ruByField[field] || issue.message,
        };
      });
      // Дедуп по field — Zod иногда даёт несколько issues на одно поле.
      const seen = new Set<string>();
      const unique = errors.filter((e) => {
        const key = e.field || '__';
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      throw new BadRequestException({
        message: unique[0]?.message || 'Ошибка валидации',
        field: unique[0]?.field,
        errors: unique,
      });
    }
    const data = parsed.data as { phone: string; fullName: string; email?: string; password: string; inn?: string; innType?: 'PERSONAL' | 'AGENCY'; agencyName?: string; offerAccepted?: boolean; privacyAccepted?: boolean };
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket?.remoteAddress
      || null;
    const ua = (req.headers['user-agent'] as string) || null;
    return this.authService.register(data, ip, ua);
  }

  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send OTP to registered broker' })
  @ApiResponse({ status: 200, description: 'OTP sent' })
  async sendOtp(@Body() body: unknown) {
    const { phone } = { phone: phoneSchema.parse((body as any)?.phone) };
    return this.authService.sendOtp(phone);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with phone and password' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  async login(@Body() body: unknown) {
    const data = loginDtoSchema.parse(body) as { phone: string; password: string };
    return this.authService.login(data);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset link via email' })
  async forgotPassword(@Body() body: unknown) {
    const { email } = forgotPasswordDtoSchema.parse(body);
    return this.authService.forgotPassword(email);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using token from email' })
  async resetPassword(@Body() body: unknown) {
    const { token, password } = resetPasswordDtoSchema.parse(body);
    return this.authService.resetPassword(token, password);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'Token refreshed' })
  async refresh(@Body() body: { refreshToken: string }) {
    return this.authService.refreshToken(body.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Current user data' })
  async getProfile(@CurrentUser() user: CurrentUserPayload) {
    return this.authService.getProfile(user.id);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update current user profile' })
  @ApiResponse({ status: 200, description: 'Profile updated' })
  async updateProfile(@CurrentUser() user: CurrentUserPayload, @Body() body: any) {
    return this.authService.updateProfile(user.id, {
      fullName: body.fullName,
      email: body.email,
      phone: body.phone,
      birthDate: body.birthDate,
      position: body.position,
      telegramUsername: body.telegramUsername,
      telegramId: body.telegramId,
      whatsappUsername: body.whatsappUsername,
      presentationSent: body.presentationSent,
      region: body.region,
      agency: body.agency,
    });
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change password (requires current password)' })
  async changePassword(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { currentPassword: string; newPassword: string },
  ) {
    return this.authService.changePassword(user.id, body.currentPassword, body.newPassword);
  }

  @Post('avatar')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Upload avatar (multipart, image only, ≤5MB)' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async uploadAvatar(
    @CurrentUser() user: CurrentUserPayload,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.authService.uploadAvatar(user.id, file);
  }
  @Post('me/agency')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Привязать агентство к текущему брокеру по ИНН' })
  async attachAgency(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { inn: string },
  ) {
    return this.authService.attachAgencyByInn(user.id, body.inn);
  }

  // 2026-06-17: смена primary-агентства (при опечатке в ИНН).
  @Post('me/agency/replace')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Заменить основное агентство брокера на новое по ИНН' })
  async replaceAgency(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: { inn: string },
  ) {
    return this.authService.replacePrimaryAgencyByInn(user.id, body.inn);
  }
}
