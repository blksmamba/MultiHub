import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { webUrl } from './shared'
import { api, modUrl } from './ui'

const schema = {
  ...defaultSchema,
  attributes: { ...defaultSchema.attributes, p: [['align', 'center']], img: [...(defaultSchema.attributes?.img ?? []), 'width', 'height'] },
  strip: [...(defaultSchema.strip ?? []), 'style', 'iframe', 'object', 'embed', 'form'],
}

const imageHosts = new Set([
  'cdn.modrinth.com', 'cdn-raw.modrinth.com', 'raw.githubusercontent.com', 'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com', 'github.com', 'i.imgur.com', 'media.forgecdn.net', 'img.shields.io',
])

function Image({ src, alt, width, height }: { src?: string | Blob; alt?: string; width?: string | number; height?: string | number }) {
  const [failed, setFailed] = useState(false)
  const url = typeof src === 'string' ? webUrl(src) : undefined
  if (failed || url?.protocol !== 'https:' || (!imageHosts.has(url.hostname) && !url.hostname.endsWith('.github.io'))) {
    return alt ? <span className="description-image-alt">{alt}</span> : null
  }
  const dimension = (value?: string | number) => typeof value !== 'undefined' && /^\d{1,4}$/.test(String(value)) ? Number(value) : undefined
  return <img src={url.href} alt={alt ?? ''} width={dimension(width)} height={dimension(height)}
    loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
}

export function ModDescription({ text, slug, report }: { text: string; slug: string; report: (error: unknown) => void }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]} components={{
    h1: ({ children }) => <h2>{children}</h2>,
    a: ({ href, children }) => {
      const url = href ? webUrl(href, modUrl(slug)) : undefined
      return url ? <a href={url.href} onClick={event => { event.preventDefault(); void api.external(url.href).catch(report) }}>{children}</a> : <span>{children}</span>
    },
    img: ({ src, alt, width, height }) => <Image key={typeof src === 'string' ? src : undefined} src={src} alt={alt} width={width} height={height} />,
    table: ({ node: _node, ...props }) => <div className="description-table"><table {...props} /></div>,
  }}>{text}</ReactMarkdown>
}
