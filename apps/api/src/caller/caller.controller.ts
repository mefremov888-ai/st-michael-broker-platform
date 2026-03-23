import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CallerService } from './caller.service';

@ApiTags('calls')
@Controller('calls')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CallerController {
  constructor(private readonly callerService: CallerService) {}

  @Get()
  @ApiOperation({ summary: 'Get call history' })
  @ApiResponse({ status: 200, description: 'Call history' })
  async getCalls() {
    return this.callerService.getCalls();
  }

  @Post('schedule')
  @ApiOperation({ summary: 'Schedule call campaign' })
  @ApiResponse({ status: 201, description: 'Campaign scheduled' })
  async scheduleCalls(@Body() body: any) {
    return this.callerService.scheduleCalls(body);
  }
}