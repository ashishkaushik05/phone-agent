import type { Db } from "../db.ts";
import { PersonasRepo } from "./personas.ts";
import { ContactsRepo } from "./contacts.ts";
import { CallsRepo } from "./calls.ts";
import { SmsRepo } from "./sms.ts";
import { WhatsappRepo } from "./whatsapp.ts";

export interface Repos {
  personas: PersonasRepo;
  contacts: ContactsRepo;
  calls: CallsRepo;
  sms: SmsRepo;
  whatsapp: WhatsappRepo;
}

export function makeRepos(db: Db): Repos {
  return {
    personas: new PersonasRepo(db),
    contacts: new ContactsRepo(db),
    calls: new CallsRepo(db),
    sms: new SmsRepo(db),
    whatsapp: new WhatsappRepo(db),
  };
}
