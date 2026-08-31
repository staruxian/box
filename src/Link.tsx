import { NavLink, Link as RouterLink } from 'react-router-dom'
import type { MouseEvent, ReactNode } from 'react'

type ClassName = string | ((state: { isActive: boolean; isPending: boolean }) => string | undefined)

type Props = {
  href: string
  children?: ReactNode
  className?: ClassName
  replace?: boolean
  prefetch?: boolean | 'auto'
  scroll?: boolean
  end?: boolean
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void
}

export default function Link({ href, children, className, replace, onClick, scroll = true, end }: Props) {
  const to = href
  const shared = { to, replace, viewTransition: true as const, onClick, preventScrollReset: !scroll }
  if (typeof className === 'function') {
    return (
      <NavLink {...shared} end={end ?? href === '/'} className={({ isActive, isPending }) => className({ isActive, isPending }) || undefined}>
        {children}
      </NavLink>
    )
  }
  return (
    <RouterLink {...shared} className={className}>
      {children}
    </RouterLink>
  )
}
