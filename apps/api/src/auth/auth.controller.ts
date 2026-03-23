import { Controller, Post, Get, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { registerDtoSchema, loginDtoSchema } from '@st-michael/shared';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register broker' })
  @ApiResponse({ status: 201, description: 'Broker registered successfully' })
  async register(@Body() body: any) {
    const data = registerDtoSchema.parse(body);
    return this.authService.register(data);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login broker' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  async login(@Body() body: any) {
    const data = loginDtoSchema.parse(body);
    return this.authService.login(data);
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
  @ApiOperation({ summary: 'Get current user' })
  @ApiResponse({ status: 200, description: 'Current user data' })
  async getProfile() {
    // User data will be available in request.user from JwtAuthGuard
    return { message: 'Profile endpoint - implement with user data' };
  }
}