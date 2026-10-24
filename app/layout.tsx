import type { Metadata } from 'next';
import './globals.css';
import './sol.css';
import SolCompanion from '@/components/sol/SolCompanion';
export const metadata: Metadata = {title: 'Helios Solar | A brighter kind of power', description: 'Thoughtful solar and battery systems for homes in Central Texas. Explore the Helios Solar demonstration website and operations workspace.'};
export default function RootLayout({children}: {children: React.ReactNode}) {return <html lang="en"><body>{children}<SolCompanion/></body></html>}
