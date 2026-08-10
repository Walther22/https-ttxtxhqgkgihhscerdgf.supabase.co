import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import MemberPortal from './member_registry_portal.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MemberPortal />
  </StrictMode>,
)