declare module 'libmime' {
  const libmime: {
    decodeWords(s: string): string;
    encodeWords(s: string, mimeWordEncoding?: string, maxLength?: number): string;
  };
  export default libmime;
}

declare module 'nodemailer/lib/mail-composer/index.js' {
  import MailComposer from 'nodemailer/lib/mail-composer';
  export default MailComposer;
}

declare module 'nodemailer/lib/addressparser/index.js' {
  interface ParsedAddress {
    name?: string;
    address?: string;
    group?: ParsedAddress[];
  }
  function addressparser(input: string): ParsedAddress[];
  export default addressparser;
}
