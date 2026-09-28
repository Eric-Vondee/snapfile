import { controllers } from '#generated/controllers'
import router from '@adonisjs/core/services/router'

router.get('/', [controllers.Compression, 'create']).as('home')
router.post('compress', [controllers.Compression, 'store']).as('compress')
router.get('stats', [controllers.Stats, 'show']).as('stats')
