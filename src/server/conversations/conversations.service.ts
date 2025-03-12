import { Injectable } from '@nestjs/common';
import { Conversation, Message, Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../prisma.service';
import {
  CreateConversationDto,
  UpdateConversationDto,
} from './conversations.dto';

@Injectable()
export class ConversationsService {
  constructor(private prisma: PrismaService) {}

  async createConversation(data: CreateConversationDto): Promise<Conversation> {
    const { messages, ...conversationData } = data;

    // Create the conversation
    const conversation = await this.prisma.conversation.create({
      data: {
        ...conversationData,
        id: uuidv4(),
        // Create messages if provided
        ...(messages && {
          messages: {
            create: messages.map((message) => ({
              id: uuidv4(),
              content: message.content,
              role: message.role,
              timestamp: message.timestamp || new Date(),
            })),
          },
        }),
      },
      include: {
        messages: true,
      },
    });

    return conversation;
  }

  async findAll(params: {
    skip?: number;
    take?: number;
    isFromCode?: boolean;
    orderBy?: Prisma.ConversationOrderByWithRelationInput;
  }): Promise<Conversation[]> {
    const { skip, take, isFromCode, orderBy } = params;

    console.log('ConversationsService faillAll', params);

    const resp = await this.prisma.conversation.findMany({
      skip,
      take,
      where: isFromCode !== undefined ? { isFromCode } : undefined,
      orderBy: orderBy || { updatedAt: 'desc' },
      include: {
        messages: {
          orderBy: {
            timestamp: 'asc',
          },
        },
      },
    });
    console.log('ConversationsService faillAll resp', resp);

    return resp;
  }

  async findOne(id: string): Promise<Conversation | null> {
    console.log('ConversationsService findOne', id);

    const resp = await this.prisma.conversation.findUnique({
      where: { id },
      include: {
        messages: {
          orderBy: {
            timestamp: 'asc',
          },
        },
      },
    });

    console.log('ConversationsService findOne result ', resp);

    return resp;
  }

  async getLatestConversation(
    isFromCode?: boolean,
  ): Promise<Conversation | null> {
    console.log(
      'ConversationsService getLatestConversation:isFromCode',
      isFromCode,
    );

    const resp = await this.prisma.conversation.findFirst({
      where: isFromCode !== undefined ? { isFromCode } : undefined,
      orderBy: { updatedAt: 'desc' },
      include: {
        messages: {
          orderBy: {
            timestamp: 'asc',
          },
        },
      },
    });

    console.log('ConversationsService getLatestConversation resp', resp);
    return resp;
  }

  async addMessageToConversation(
    conversationId: string,
    data: { content: string; role: string },
  ): Promise<Message> {
    // First check if conversation exists
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation) {
      throw new Error(`Conversation with ID ${conversationId} not found`);
    }

    // Create new message
    const message = await this.prisma.message.create({
      data: {
        id: uuidv4(),
        content: data.content,
        role: data.role,
        conversation: {
          connect: { id: conversationId },
        },
      },
    });

    // Update conversation's updatedAt timestamp
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    return message;
  }

  async updateConversation(
    id: string,
    data: UpdateConversationDto,
  ): Promise<Conversation> {
    const { messages, ...conversationData } = data;

    console.log('ConversationsService updateConversation', id, data);

    // Update the conversation
    const updatedConversation = await this.prisma.conversation.update({
      where: { id },
      data: conversationData,
    });

    console.log(
      'ConversationsService updateConversation resp',
      updatedConversation,
    );

    // If new messages are provided, add them
    if (messages && messages.length > 0) {
      for (const message of messages) {
        await this.prisma.message.create({
          data: {
            id: uuidv4(),
            content: message.content,
            role: message.role,
            timestamp: message.timestamp || new Date(),
            conversation: {
              connect: { id },
            },
          },
        });
      }
    }

    // Return updated conversation with messages
    return this.findOne(id);
  }

  async deleteConversation(id: string): Promise<Conversation> {
    return this.prisma.conversation.delete({
      where: { id },
    });
  }

  async searchConversations(searchTerm: string): Promise<Conversation[]> {
    console.log('ConversationsService searchConversations', searchTerm);

    const resp = await this.prisma.conversation.findMany({
      where: {
        OR: [
          {
            title: {
              contains: searchTerm,
            },
          },
          {
            sourceCode: {
              contains: searchTerm,
            },
          },
          {
            messages: {
              some: {
                content: {
                  contains: searchTerm,
                },
              },
            },
          },
        ],
      },
      include: {
        messages: {
          orderBy: {
            timestamp: 'asc',
          },
        },
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });
    console.log('ConversationsService searchConversations resp', resp);

    return resp;
  }
}
