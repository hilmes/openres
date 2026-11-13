import { expect, it } from 'vitest';
import { venue } from './venue';
import { venueSchema } from './schema';
it('accepts another venue, IANA timezone, areas and floor geometry',()=>{
  const result=venueSchema.parse({...venue,name:'Example Bistro',timeZone:'Europe/Paris',areas:{terrace:'Terrace'},tables:[{id:'A1',seats:4,area:'terrace',x:.3,y:.5,shape:'square'}]});
  expect(result.tables[0].area).toBe('terrace');
});
it('rejects duplicate tables, invalid zones and unknown areas',()=>{
  expect(venueSchema.safeParse({...venue,tables:[venue.tables[0],venue.tables[0]]}).success).toBe(false);
  expect(venueSchema.safeParse({...venue,timeZone:'Not/AZone'}).success).toBe(false);
  expect(venueSchema.safeParse({...venue,areas:{other:'Other'}}).success).toBe(false);
});
