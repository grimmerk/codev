import { Controller, Get, Post, Body, Param, Delete, Put, Query } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { 
  CreateConversationDto, 
  UpdateConversationDto, 
  AddMessageDto, 
  SearchConversationsDto 
} from './conversations.dto';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post()
  async create(@Body() createConversationDto: CreateConversationDto) {
    return this.conversationsService.createConversation(createConversationDto);
  }

  @Get()
  async findAll(
    @Query('skip') skip?: string,
    @Query('take') take?: string,
    @Query('isFromCode') isFromCode?: string,
  ) {
    // Convert query parameters to appropriate types
    return this.conversationsService.findAll({
      skip: skip ? parseInt(skip, 10) : undefined,
      take: take ? parseInt(take, 10) : undefined,
      isFromCode: isFromCode !== undefined ? isFromCode === 'true' : undefined,
    });
  }

  @Get('latest')
  async getLatestConversation(@Query('isFromCode') isFromCode?: string) {
    return this.conversationsService.getLatestConversation(
      isFromCode !== undefined ? isFromCode === 'true' : undefined
    );
  }

  @Get('search')
  async search(@Query('term') searchTerm: string) {
    return this.conversationsService.searchConversations(searchTerm);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.conversationsService.findOne(id);
  }

  @Post(':id/messages')
  async addMessage(
    @Param('id') id: string,
    @Body() addMessageDto: AddMessageDto,
  ) {
    return this.conversationsService.addMessageToConversation(id, addMessageDto);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() updateConversationDto: UpdateConversationDto,
  ) {
    return this.conversationsService.updateConversation(id, updateConversationDto);
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    return this.conversationsService.deleteConversation(id);
  }
}