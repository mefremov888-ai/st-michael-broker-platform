export interface IWhatsAppAdapter {
  sendMessage(phone: string, text: string): Promise<void>;
  sendDocument(phone: string, documentUrl: string, caption: string): Promise<void>;
  sendImage(phone: string, imageUrl: string, caption: string): Promise<void>;
}

export class WhatsAppAdapter implements IWhatsAppAdapter {
  // TODO: Implement actual WhatsApp Business API integration
  async sendMessage(phone: string, text: string): Promise<void> {
    console.log('WhatsAppAdapter: sendMessage', { phone, text });
    // Stub implementation
  }

  async sendDocument(phone: string, documentUrl: string, caption: string): Promise<void> {
    console.log('WhatsAppAdapter: sendDocument', { phone, documentUrl, caption });
    // Stub implementation
  }

  async sendImage(phone: string, imageUrl: string, caption: string): Promise<void> {
    console.log('WhatsAppAdapter: sendImage', { phone, imageUrl, caption });
    // Stub implementation
  }
}