import type { EmailMessage } from './email';

// The texts are the ones users-api sent before the emails moved to RabbitMQ.

export function verificationEmail(to: string, verificationUrl: string): EmailMessage {
  return {
    to,
    subject: 'Validá tu cuenta de UdeSA-X',
    text: [
      'Hola,',
      '',
      'Para terminar de crear tu cuenta de UdeSA-X, abrí este link:',
      '',
      verificationUrl,
      '',
      'El link vence. Si ya no funciona, pedí uno nuevo desde la app.',
      '',
      'Si no creaste una cuenta, ignorá este correo.',
    ].join('\n'),
  };
}

export function passwordResetEmail(to: string, token: string): EmailMessage {
  return {
    to,
    subject: 'Recuperá tu contraseña de UdeSA-X',
    text: [
      'Hola,',
      '',
      'Pediste cambiar la contraseña de tu cuenta de UdeSA-X. Pegá este código en la app, en la pantalla de nueva contraseña:',
      '',
      token,
      '',
      'El código vence en pocos minutos y sirve una sola vez.',
      '',
      'Si no lo pediste, ignorá este correo: tu contraseña sigue igual.',
    ].join('\n'),
  };
}

export function passwordChangedEmail(to: string): EmailMessage {
  return {
    to,
    subject: 'La contraseña de tu cuenta de UdeSA-X cambió',
    text: [
      'Hola,',
      '',
      'La contraseña de tu cuenta de UdeSA-X acaba de cambiar y se cerraron todas las sesiones abiertas.',
      '',
      'Si no fuiste vos, recuperá el acceso desde Olvidé mi contraseña en la app.',
    ].join('\n'),
  };
}
